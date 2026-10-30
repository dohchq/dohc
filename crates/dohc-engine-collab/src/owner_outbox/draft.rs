//! Non-host owner drafts backed by an authenticated accepted checkpoint.
use super::*;
use crate::{CollabError, DocKey, Ydoc};

const SAFE: i64 = 9_007_199_254_740_991;
const SCOPE: &str =
    "workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4";

#[derive(Debug, Clone)]
pub struct ObservedOwnerBinding {
    pub binding: LiveObjectBinding,
    pub relay_database_namespace: String,
    pub revision: i64,
    pub accepted_cursor: i64,
    pub native_head_sequence: i64,
    pub checkpoint_digest: String,
    pub limits: OwnerOutboxLimits,
}

pub struct OwnerDraft {
    pub observed: ObservedOwnerBinding,
    pub doc: Ydoc,
}

#[derive(PartialEq, Eq)]
struct DraftProof {
    binding_json: String,
    namespace: String,
    revision: i64,
    native_head: i64,
    accepted_cursor: i64,
    checkpoint_digest: String,
    parent: Option<(String, i64, i64, OwnerOutboxState)>,
}

pub(crate) struct CachedOwnerDraft {
    draft: OwnerDraft,
    proof: DraftProof,
    pub(crate) approx_bytes: usize,
    pub(crate) last_used: u64,
}

fn draft_proof(
    conn: &Connection,
    binding: &LiveObjectBinding,
    revision: i64,
) -> Result<DraftProof, OwnerOutboxError> {
    let observed = super::accepted::current(conn, binding)?;
    if observed.revision != revision {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let parent = find_parent_for_binding(conn, binding)?;
    if parent
        .as_ref()
        .is_some_and(|p| p.binding != *binding || p.state == OwnerOutboxState::Quarantined)
    {
        return Err(OwnerOutboxError::Frozen);
    }
    Ok(DraftProof {
        binding_json: binding_json(binding)?,
        namespace: observed.relay_database_namespace,
        revision,
        native_head: observed.native_head_sequence,
        accepted_cursor: observed.accepted_cursor,
        checkpoint_digest: observed.checkpoint_digest,
        parent: parent.map(|p| (p.outbox_id, p.next_sequence, p.pending_bytes, p.state)),
    })
}

#[derive(Clone)]
pub struct OwnerDraftAppendInput {
    pub person_edit: bool,
    pub binding: LiveObjectBinding,
    pub expected_revision: i64,
    pub append_key: String,
    pub update: Vec<u8>,
    pub now_ms: i64,
    /// The agent the edit declared, kept with its delivery. Never authority.
    pub agent_declaration: Option<dohc_engine_domain::AgentDeclaration>,
    pub automation_declaration: Option<dohc_engine_domain::AutomationDeclaration>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerDraftCursor {
    pub main_version_id: String,
    pub object_id: String,
    pub lineage_claim_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerDraftWrite {
    pub outbox_id: Option<String>,
    pub binding: LiveObjectBinding,
    pub native_head_sequence: i64,
    pub append_key: String,
}

/// Read the acceptance of these exact entries. Paths and later drafts are not evidence.
pub fn write_states_in(
    conn: &Connection,
    workspace: &str,
    writes: &[OwnerDraftWrite],
) -> Result<Vec<String>, OwnerOutboxError> {
    if writes.len() > 64 {
        return Err(OwnerOutboxError::InvalidInput("invalid write status batch"));
    }
    writes.iter().map(|write| {
        let b = &write.binding;
        b.validate_canonical().map_err(OwnerOutboxError::InvalidInput)?;
        require_workspace(workspace, &b.workspace_id)?;
        validate_identifier(&write.append_key, "invalid append key")?;
        if !(0..=SAFE).contains(&write.native_head_sequence) {
            return Err(OwnerOutboxError::InvalidInput("invalid write sequence"));
        }
        let parent = write.outbox_id.as_ref().map(|id| {
            validate_identifier(id, "invalid outbox id")?;
            let Some(parent) = read_parent(conn, id)? else { return Ok(None); };
            if parent.binding.workspace_id != b.workspace_id ||
                parent.binding.main_version_id != b.main_version_id ||
                parent.binding.object_id != b.object_id ||
                parent.binding.lineage_claim_id != b.lineage_claim_id ||
                parent.binding.restore_fence_generation != b.restore_fence_generation {
                return Err(OwnerOutboxError::ParentMismatch);
            }
            Ok(Some(parent))
        }).transpose()?.flatten();
        if parent.is_none() { return Ok("absent".to_owned()); }
        if let Some(ref parent) = parent {
            let entry: Option<(bool, bool)> = conn.query_row(
                "SELECT pending=0,accepted_receipt_json IS NOT NULL FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND append_key=?2",
                params![parent.outbox_id,write.append_key], |row| Ok((row.get(0)?,row.get(1)?)),
            ).optional().map_err(read_sql)?;
            match entry {
                Some((true, true)) => return Ok("settled".to_owned()),
                Some((true, false)) => return Ok("not-accepted".to_owned()),
                None => return Ok("absent".to_owned()),
                Some((false, _)) => {}
            }
        }
        let raw: Option<ObservedBindingRow> = conn.query_row(
            &format!("SELECT binding_json,relay_database_namespace,binding_revision,accepted_cursor,native_head_sequence,checkpoint_digest,max_pending_bytes,max_pending_age_ms FROM ydoc_owner_bindings WHERE {SCOPE}"),
            params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id], read_observed_row,
        ).optional().map_err(read_sql)?;
        let observed = raw.map(decode_observed).transpose()?;
        if parent.as_ref().is_some_and(|p| p.state == OwnerOutboxState::Quarantined) ||
            observed.as_ref().is_some_and(|o| o.binding.restore_fence_generation != b.restore_fence_generation) {
            return Ok("not-accepted".to_owned());
        }
        // Without an entry receipt, a drained queue or a newer native head cannot prove this write was accepted.
        Ok("pending".to_owned())
    }).collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerDraftDescriptor {
    pub binding: LiveObjectBinding,
    pub relay_database_namespace: String,
    pub revision: i64,
    pub accepted_cursor: i64,
    pub native_head_sequence: i64,
    /// The native head is not yet covered by its materialized file.
    pub native_unsettled: bool,
    pub outbox_id: Option<String>,
    pub pending_bytes: i64,
    pub state: Option<String>,
}

/// Resolve the editor's object to its current observed binding. A stale binding
/// freezes the object instead of falling back to ordinary document writes.
pub fn descriptor_for_key_in(
    conn: &Connection,
    key: &DocKey,
) -> Result<Option<OwnerDraftDescriptor>, OwnerOutboxError> {
    let mut stmt = conn.prepare("SELECT binding_json FROM ydoc_owner_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 LIMIT 2").map_err(read_sql)?;
    let bindings = stmt
        .query_map(
            params![key.workspace_id, key.version_id, key.object_id],
            |r| r.get::<_, String>(0),
        )
        .map_err(read_sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(read_sql)?;
    if bindings.len() > 1 {
        return Err(OwnerOutboxError::Frozen);
    }
    let Some(json) = bindings.first() else {
        return Ok(None);
    };
    let binding: LiveObjectBinding =
        serde_json::from_str(json).map_err(|_| OwnerOutboxError::Corrupt)?;
    binding
        .validate_canonical()
        .map_err(OwnerOutboxError::InvalidInput)?;
    let observed = super::accepted::current(conn, &binding)?;
    describe_draft(conn, observed).map(Some)
}

pub fn list_drafts_in(
    conn: &Connection,
    workspace_id: &str,
    after: Option<&OwnerDraftCursor>,
    limit: usize,
    pending_only: bool,
) -> Result<Vec<OwnerDraftDescriptor>, OwnerOutboxError> {
    validate_identifier(workspace_id, "invalid workspace")?;
    if !(1..=64).contains(&limit) {
        return Err(OwnerOutboxError::InvalidInput("invalid draft page size"));
    }
    if let Some(cursor) = after {
        validate_identifier(&cursor.main_version_id, "invalid draft cursor")?;
        validate_identifier(&cursor.object_id, "invalid draft cursor")?;
        validate_digest(&cursor.lineage_claim_id)?;
    }
    let (version, object, lineage) = after
        .map(|c| {
            (
                c.main_version_id.as_str(),
                c.object_id.as_str(),
                c.lineage_claim_id.as_str(),
            )
        })
        .unwrap_or(("", "", ""));
    let mut stmt = conn.prepare("SELECT binding_json,relay_database_namespace,binding_revision,accepted_cursor,native_head_sequence,checkpoint_digest,max_pending_bytes,max_pending_age_ms FROM ydoc_owner_bindings b WHERE workspace_id=?1 AND (main_version_id,object_id,lineage_claim_id)>(?2,?3,?4) AND (?6=0 OR EXISTS (SELECT 1 FROM owner_ydoc_outboxes o WHERE o.workspace_id=b.workspace_id AND o.main_version_id=b.main_version_id AND o.object_id=b.object_id AND o.lineage_claim_id=b.lineage_claim_id AND o.restore_fence_generation=json_extract(b.binding_json,'$.restoreFenceGeneration') AND o.current_path=json_extract(b.binding_json,'$.currentPath') AND json(o.selector_paths_json)=json_extract(b.binding_json,'$.selectorPaths') AND o.pending_bytes>0 AND (o.state!='quarantined' OR o.retry_delivery_id IS NOT NULL))) ORDER BY main_version_id,object_id,lineage_claim_id LIMIT ?5").map_err(read_sql)?;
    let rows = stmt
        .query_map(
            params![
                workspace_id,
                version,
                object,
                lineage,
                limit as i64,
                pending_only
            ],
            read_observed_row,
        )
        .map_err(read_sql)?;
    rows.map(|row| {
        let observed = decode_observed(row.map_err(read_sql)?)?;
        require_workspace(workspace_id, &observed.binding.workspace_id)?;
        describe_draft(conn, observed)
    })
    .collect()
}

fn describe_draft(
    conn: &Connection,
    observed: ObservedOwnerBinding,
) -> Result<OwnerDraftDescriptor, OwnerOutboxError> {
    let parent = find_parent_for_binding(conn, &observed.binding)?;
    let b = &observed.binding;
    let native_unsettled = conn.query_row(
        "SELECT NOT (d.settled_update_seq IS d.head_update_seq \
           AND s.blob_sha256 IS NOT NULL AND s.path=?4 \
           AND COALESCE(d.last_settled_sha, d.seed_source_sha256) IS s.blob_sha256 \
           AND NOT EXISTS (SELECT 1 FROM materialization_jobs j \
             WHERE j.workspace_id IN (?1, '') AND j.target_path=?4 AND j.status='pending') \
           AND COALESCE((SELECT j.status='conflict' AND j.content_sha256=s.blob_sha256 \
             FROM materialization_jobs j WHERE j.workspace_id IN (?1, '') AND j.target_path=?4 \
             ORDER BY j.created_at_ms DESC, j.rowid DESC LIMIT 1), 0)=0) \
         FROM ydoc_docs d LEFT JOIN snapshots s \
           ON s.workspace_id=d.workspace_id AND s.version_id=d.version_id AND s.object_id=d.object_id \
         WHERE d.workspace_id=?1 AND d.version_id=?2 AND d.object_id=?3",
        params![b.workspace_id, b.main_version_id, b.object_id, b.current_path],
        |row| row.get(0),
    ).optional().map_err(read_sql)?.unwrap_or(true);
    Ok(OwnerDraftDescriptor {
        binding: observed.binding,
        relay_database_namespace: observed.relay_database_namespace,
        revision: observed.revision,
        accepted_cursor: observed.accepted_cursor,
        native_head_sequence: observed.native_head_sequence,
        native_unsettled,
        outbox_id: parent.as_ref().map(|p| p.outbox_id.clone()),
        pending_bytes: parent.as_ref().map_or(0, |p| p.pending_bytes),
        state: parent.map(|p| p.state.as_str().to_owned()),
    })
}

pub struct OwnerDraftSnapshot {
    pub descriptor: OwnerDraftDescriptor,
    pub initial_update: Vec<u8>,
}

pub fn open_draft_cached(
    store: &EngineStore,
    cache: &mut crate::WriterDocCache,
    binding: &LiveObjectBinding,
    revision: i64,
) -> Result<OwnerDraftSnapshot, OwnerOutboxError> {
    let key = key(binding)?;
    let cached = cache.take_owner_draft(&key);
    let (snapshot, cached) = store.read_with(|conn| {
        let proof = draft_proof(conn, binding, revision)?;
        let draft = match cached {
            Some(entry) if entry.proof == proof => entry.draft,
            _ => open_draft_in(conn, binding, revision)?,
        };
        let initial_update = bounded(&draft.doc)?;
        let approx_bytes = initial_update
            .len()
            .saturating_add(proof.binding_json.len().saturating_mul(2))
            .saturating_add(proof.namespace.len());
        let snapshot = OwnerDraftSnapshot {
            descriptor: describe_draft(conn, draft.observed.clone())?,
            initial_update,
        };
        Ok::<_, OwnerOutboxError>((
            snapshot,
            CachedOwnerDraft {
                draft,
                proof,
                approx_bytes,
                last_used: 0,
            },
        ))
    })?;
    cache.put_owner_draft(key, cached);
    Ok(snapshot)
}

/// The cache owns no durable authority. A refused or rolled-back candidate is
/// dropped; a committed candidate names the exact checkpoint and pending queue.
pub fn append_draft_cached(
    store: &mut EngineStore,
    cache: &mut crate::WriterDocCache,
    workspace_id: &str,
    input: OwnerDraftAppendInput,
    faults: &dyn dohc_engine_storage::FaultInjector,
) -> Result<OwnerOutboxAppendResult, OwnerOutboxError> {
    let key = key(&input.binding)?;
    let cached = cache.take_owner_draft(&key);
    let mut retained = None;
    let result = store.write_with(faults, |tx| {
        let proof = draft_proof(tx, &input.binding, input.expected_revision)?;
        let draft = match cached {
            Some(entry) if entry.proof == proof => entry.draft,
            _ => open_draft_in(tx, &input.binding, input.expected_revision)?,
        };
        let (result, encoded_len) = append_prepared_draft_in_tx(
            tx,
            workspace_id,
            &draft,
            PreparedDraftAppend {
                person_edit: input.person_edit,
                append_key: input.append_key,
                update: input.update,
                now_ms: input.now_ms,
                agent_declaration: input.agent_declaration.as_ref(),
                automation_declaration: input.automation_declaration.as_ref(),
            },
        )?;
        let proof = draft_proof(tx, &input.binding, input.expected_revision)?;
        let approx_bytes = encoded_len
            .saturating_add(proof.binding_json.len().saturating_mul(2))
            .saturating_add(proof.namespace.len());
        retained = Some(CachedOwnerDraft {
            draft,
            proof,
            approx_bytes,
            last_used: 0,
        });
        Ok(result)
    });
    match result {
        Ok(TxnOutcome::Committed(result)) => {
            if let Some(draft) = retained {
                cache.put_owner_draft(key, draft);
            }
            Ok(result)
        }
        Ok(TxnOutcome::Crashed { .. }) => Err(OwnerOutboxError::Corrupt),
        Err(error) => Err(error),
    }
}

pub(super) fn collab(error: CollabError) -> OwnerOutboxError {
    match error {
        CollabError::Storage(error) => OwnerOutboxError::Storage(error),
        _ => OwnerOutboxError::InvalidInput("invalid owner draft state"),
    }
}
pub(super) fn key(binding: &LiveObjectBinding) -> Result<DocKey, OwnerOutboxError> {
    DocKey::new(
        &binding.workspace_id,
        &binding.main_version_id,
        &binding.object_id,
    )
    .map_err(collab)
}
pub(super) fn bounded(doc: &Ydoc) -> Result<Vec<u8>, OwnerOutboxError> {
    doc.encode_full_state_bounded(crate::limits::MAX_YDOC_UPDATE_BYTES)
        .ok_or(OwnerOutboxError::InvalidInput(
            "owner draft exceeds document limit",
        ))
}

/// Refuse ordinary publication and settlement before either writes durable state.
pub fn require_ordinary_write(conn: &Connection, key: &DocKey) -> Result<(), CollabError> {
    let observed: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM ydoc_owner_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3)",
        params![key.workspace_id, key.version_id, key.object_id], |row| row.get(0),
    ).map_err(|error| CollabError::Storage(StorageError::corrupt_public(error)))?;
    if observed {
        Err(CollabError::OwnerOutboxFrozen)
    } else {
        Ok(())
    }
}

/// The caller must verify the full checkpoint through authenticated owner transport.
/// Initial installation accepts an already-converged native state only. It does
/// not replace divergent ordinary state, manufacture an ACK, or adopt a host.
pub fn install_observed_binding_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    observed: &ObservedOwnerBinding,
    authenticated_checkpoint: &[u8],
) -> Result<(), OwnerOutboxError> {
    let b = &observed.binding;
    b.validate_canonical()
        .map_err(OwnerOutboxError::InvalidInput)?;
    require_workspace(workspace_id, &b.workspace_id)?;
    validate_identifier(
        &observed.relay_database_namespace,
        "invalid relay namespace",
    )?;
    observed.limits.validate()?;
    if observed.revision != 1
        || !(0..=SAFE).contains(&observed.accepted_cursor)
        || !(0..=SAFE).contains(&observed.native_head_sequence)
        || authenticated_checkpoint.len() > crate::limits::MAX_YDOC_UPDATE_BYTES
    {
        return Err(OwnerOutboxError::InvalidInput("invalid initial checkpoint"));
    }
    let key = key(b)?;
    let marker = crate::read_marker_in(tx, &key)
        .map_err(collab)?
        .ok_or(OwnerOutboxError::NotFound)?;
    if marker.content_kind != crate::ContentKind::Richdoc
        || marker.regime != crate::Regime::Replicated
        || marker.lineage_claim_id.as_deref() != Some(&b.lineage_claim_id)
        || marker.path.as_deref() != Some(&b.current_path)
        || marker.head_update_seq != observed.native_head_sequence
    {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    // An adopted lineage stays the owner's after its activation's release,
    // while its native log may hold the deliveries the release carried.
    let adopted: bool = tx.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {} WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3) OR EXISTS(SELECT 1 FROM live_owner_adoptions WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4)", crate::live_update_application::owner_activations::CURRENT_ACTIVATIONS),
        params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id], |row| row.get(0),
    ).map_err(read_sql)?;
    if adopted {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let original = bounded_blob(tx, &b.lineage_claim_id)?;
    Ydoc::validate_update(&original).map_err(collab)?;
    let checkpoint = Ydoc::wire();
    checkpoint.apply(authenticated_checkpoint).map_err(collab)?;
    if checkpoint.has_pending_dependencies() {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let bytes = bounded(&checkpoint)?;
    if hex_sha256(&bytes) != observed.checkpoint_digest
        || bounded(&crate::load_doc_in(tx, &key).map_err(collab)?)? != bytes
    {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    if let Some(saved) = read_observed_in(tx, b)? {
        if binding_json(&saved.binding)? == binding_json(b)?
            && saved.relay_database_namespace == observed.relay_database_namespace
            && saved.revision == observed.revision
            && saved.accepted_cursor == observed.accepted_cursor
            && saved.native_head_sequence == observed.native_head_sequence
            && saved.checkpoint_digest == observed.checkpoint_digest
            && saved.limits.max_pending_bytes == observed.limits.max_pending_bytes
            && saved.limits.max_pending_age_ms == observed.limits.max_pending_age_ms
        {
            return Ok(());
        }
        return Err(OwnerOutboxError::ParentMismatch);
    }
    require_ordinary_write(tx, &key).map_err(collab)?;
    put_binary_blob_with_sha(tx, &bytes, &observed.checkpoint_digest)?;
    tx.execute(
        "INSERT INTO ydoc_owner_bindings VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![
            b.workspace_id,
            b.main_version_id,
            b.object_id,
            b.lineage_claim_id,
            binding_json(b)?,
            observed.relay_database_namespace,
            observed.revision,
            observed.accepted_cursor,
            observed.native_head_sequence,
            observed.checkpoint_digest,
            observed.limits.max_pending_bytes,
            observed.limits.max_pending_age_ms
        ],
    )
    .map_err(write_sql)?;
    Ok(())
}

pub(super) fn bounded_blob(conn: &Connection, digest: &str) -> Result<Vec<u8>, OwnerOutboxError> {
    validate_digest(digest)?;
    let bytes: Vec<u8> = conn.query_row(
        "SELECT bytes FROM binary_blobs WHERE sha256=?1 AND byte_length=length(bytes) AND byte_length BETWEEN 1 AND ?2",
        params![digest, crate::limits::MAX_YDOC_UPDATE_BYTES as i64], |row| row.get(0),
    ).optional().map_err(read_sql)?.ok_or(OwnerOutboxError::Corrupt)?;
    if hex_sha256(&bytes) != digest {
        return Err(OwnerOutboxError::Corrupt);
    }
    Ok(bytes)
}
type ObservedBindingRow = (String, String, i64, i64, i64, String, i64, i64);
fn read_observed_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ObservedBindingRow> {
    Ok((
        r.get(0)?,
        r.get(1)?,
        r.get(2)?,
        r.get(3)?,
        r.get(4)?,
        r.get(5)?,
        r.get(6)?,
        r.get(7)?,
    ))
}
fn decode_observed(r: ObservedBindingRow) -> Result<ObservedOwnerBinding, OwnerOutboxError> {
    let binding: LiveObjectBinding =
        serde_json::from_str(&r.0).map_err(|_| OwnerOutboxError::Corrupt)?;
    binding
        .validate_canonical()
        .map_err(OwnerOutboxError::InvalidInput)?;
    Ok(ObservedOwnerBinding {
        binding,
        relay_database_namespace: r.1,
        revision: r.2,
        accepted_cursor: r.3,
        native_head_sequence: r.4,
        checkpoint_digest: r.5,
        limits: OwnerOutboxLimits {
            max_pending_bytes: r.6,
            max_pending_age_ms: r.7,
        },
    })
}
pub(super) fn read_observed_in(
    conn: &Connection,
    binding: &LiveObjectBinding,
) -> Result<Option<ObservedOwnerBinding>, OwnerOutboxError> {
    let b = binding;
    let raw:Option<ObservedBindingRow>=conn.query_row(
        &format!("SELECT binding_json,relay_database_namespace,binding_revision,accepted_cursor,native_head_sequence,checkpoint_digest,max_pending_bytes,max_pending_age_ms FROM ydoc_owner_bindings WHERE {SCOPE}"),
        params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],read_observed_row,
    ).optional().map_err(read_sql)?;
    raw.map(|row| {
        let observed = decode_observed(row)?;
        if &observed.binding != binding {
            return Err(OwnerOutboxError::ParentMismatch);
        }
        Ok(observed)
    })
    .transpose()
}

/// Replay without refused bytes; never retain a candidate's missing dependencies.
pub(super) fn refuse_dependent_entries_in_tx(
    tx: &rusqlite::Transaction<'_>,
    outbox_id: &str,
    checkpoint_digest: &str,
) -> Result<Ydoc, OwnerOutboxError> {
    let entries = {
        let mut stmt = tx.prepare("SELECT sequence,update_digest,byte_length,accepted_receipt_json FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND pending=1 ORDER BY sequence").map_err(read_sql)?;
        let entries = stmt
            .query_map([outbox_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(read_sql)?;
        entries.collect::<Result<Vec<_>, _>>().map_err(read_sql)?
    };
    let mut accepted_bytes = bounded_blob(tx, checkpoint_digest)?;
    let mut accepted = Ydoc::wire();
    accepted.apply(&accepted_bytes).map_err(collab)?;
    for (sequence, digest, length, receipt) in entries {
        let update = bounded_blob(tx, &digest)?;
        if update.len() as i64 != length {
            return Err(OwnerOutboxError::Corrupt);
        }
        let candidate = Ydoc::wire();
        candidate.apply(&accepted_bytes).map_err(collab)?;
        candidate.apply(&update).map_err(collab)?;
        if candidate.has_pending_dependencies() {
            if receipt.is_some() {
                return Err(OwnerOutboxError::ReceiptMismatch);
            }
            tx.execute("UPDATE owner_ydoc_outbox_entries SET pending=0,terminal_blob_digest=update_blob_digest,update_blob_digest=NULL,terminal_reason='An earlier write was not accepted.' WHERE outbox_id=?1 AND sequence=?2 AND pending=1", params![outbox_id,sequence]).map_err(write_sql)?;
        } else {
            accepted_bytes = bounded(&candidate)?;
            accepted = candidate;
        }
    }
    Ok(accepted)
}

/// The caller holds one transaction through opening or appending a draft.
pub fn open_draft_in(
    conn: &Connection,
    binding: &LiveObjectBinding,
    expected_revision: i64,
) -> Result<OwnerDraft, OwnerOutboxError> {
    let observed = read_observed_in(conn, binding)?.ok_or(OwnerOutboxError::NotFound)?;
    if observed.revision != expected_revision {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let marker = crate::read_marker_in(conn, &key(binding)?)
        .map_err(collab)?
        .ok_or(OwnerOutboxError::NotFound)?;
    if marker.content_kind != crate::ContentKind::Richdoc
        || marker.regime != crate::Regime::Replicated
        || marker.head_update_seq != observed.native_head_sequence
        || marker.lineage_claim_id.as_deref() != Some(&binding.lineage_claim_id)
        || marker.path.as_deref() != Some(&binding.current_path)
    {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let doc = Ydoc::wire();
    doc.apply(&bounded_blob(conn, &observed.checkpoint_digest)?)
        .map_err(collab)?;
    apply_pending_in(
        conn,
        binding,
        &doc,
        observed.limits.max_pending_bytes,
        PendingReplay::Draft,
    )?;
    Ok(OwnerDraft { observed, doc })
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum PendingReplay {
    Draft,
    Checkpoint,
}

/// Merge active drafts into an accepted checkpoint for Collection indexing.
/// Quarantined work stays frozen and cannot block accepted state advancing.
pub fn apply_pending_to_checkpoint_in(
    conn: &Connection,
    binding: &LiveObjectBinding,
    doc: &Ydoc,
) -> Result<(), OwnerOutboxError> {
    let observed = read_observed_in(conn, binding)?.ok_or(OwnerOutboxError::NotFound)?;
    apply_pending_in(
        conn,
        binding,
        doc,
        observed.limits.max_pending_bytes,
        PendingReplay::Checkpoint,
    )
}

pub(super) fn apply_pending_in(
    conn: &Connection,
    binding: &LiveObjectBinding,
    doc: &Ydoc,
    max_pending_bytes: i64,
    replay: PendingReplay,
) -> Result<(), OwnerOutboxError> {
    if let Some(parent) = find_parent_for_binding(conn, binding)? {
        if parent.binding != *binding {
            return Err(OwnerOutboxError::Frozen);
        }
        if parent.state == OwnerOutboxState::Quarantined {
            return match replay {
                PendingReplay::Draft => Err(OwnerOutboxError::Frozen),
                PendingReplay::Checkpoint => Ok(()),
            };
        }
        if replay == PendingReplay::Checkpoint && parent.pending_bytes == 0 {
            return Ok(());
        }
        let mut stmt = conn.prepare("SELECT update_digest,byte_length FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND pending=1 ORDER BY sequence").map_err(read_sql)?;
        let rows = stmt
            .query_map([parent.outbox_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })
            .map_err(read_sql)?;
        let mut remaining = max_pending_bytes
            .checked_add(crate::limits::MAX_YDOC_UPDATE_BYTES as i64)
            .ok_or(OwnerOutboxError::Corrupt)?;
        for row in rows {
            let (digest, len) = row.map_err(read_sql)?;
            if len < 1 || len > remaining {
                return Err(OwnerOutboxError::Corrupt);
            }
            remaining -= len;
            let bytes = bounded_blob(conn, &digest)?;
            if bytes.len() as i64 != len {
                return Err(OwnerOutboxError::Corrupt);
            }
            doc.apply(&bytes).map_err(collab)?;
            if replay == PendingReplay::Draft {
                bounded(doc)?;
            }
        }
    }
    if doc.has_pending_dependencies() {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    // Indexing reads fields only; it does not persist the merged document.
    Ok(())
}

/// Enrollment and restore capture queue merged native state, which declares
/// no agent. An editor's draft goes through [`append_draft_cached`].
pub fn append_draft_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    binding: &LiveObjectBinding,
    expected_revision: i64,
    append_key: String,
    update: Vec<u8>,
    now_ms: i64,
) -> Result<OwnerOutboxAppendResult, OwnerOutboxError> {
    require_workspace(workspace_id, &binding.workspace_id)?;
    let draft = open_draft_in(tx, binding, expected_revision)?;
    append_prepared_draft_in_tx(
        tx,
        workspace_id,
        &draft,
        PreparedDraftAppend {
            person_edit: false,
            append_key,
            update,
            now_ms,
            agent_declaration: None,
            automation_declaration: None,
        },
    )
    .map(|(result, _)| result)
}

struct PreparedDraftAppend<'a> {
    person_edit: bool,
    append_key: String,
    update: Vec<u8>,
    now_ms: i64,
    agent_declaration: Option<&'a dohc_engine_domain::AgentDeclaration>,
    automation_declaration: Option<&'a dohc_engine_domain::AutomationDeclaration>,
}

fn append_prepared_draft_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    draft: &OwnerDraft,
    input: PreparedDraftAppend<'_>,
) -> Result<(OwnerOutboxAppendResult, usize), OwnerOutboxError> {
    let PreparedDraftAppend {
        person_edit,
        append_key,
        update,
        now_ms,
        agent_declaration,
        automation_declaration,
    } = input;
    let binding = &draft.observed.binding;
    require_workspace(workspace_id, &binding.workspace_id)?;
    if update.is_empty() || update.len() > crate::limits::MAX_YDOC_UPDATE_BYTES {
        return Err(OwnerOutboxError::InvalidInput("invalid draft update size"));
    }
    let epoch = draft.doc.lineage_epoch_tag();
    draft.doc.apply(&update).map_err(collab)?;
    if draft.doc.has_pending_dependencies() || draft.doc.lineage_epoch_tag() != epoch {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    draft
        .doc
        .project(crate::ContentKind::Richdoc)
        .map_err(collab)?;
    let encoded_len = bounded(&draft.doc)?.len();
    let result = append_with_retained_base(
        tx,
        workspace_id,
        OwnerOutboxAppendInput {
            binding: binding.clone(),
            base_update: bounded_blob(tx, &binding.lineage_claim_id)?,
            append_key,
            update,
            limits: draft.observed.limits.clone(),
            created_at_ms: now_ms,
        },
        None,
        Some(draft.observed.revision),
        agent_declaration,
        automation_declaration,
        person_edit,
    )?;
    let attribution = automation_declaration
        .map(|declaration| declaration.attribution.clone())
        .or_else(|| agent_declaration.map(AgentDeclaration::attribution));
    let actor = automation_declaration
        .map(|declaration| declaration.automation_id.as_str())
        .or_else(|| agent_declaration.map(|declaration| declaration.agent_id.as_str()));
    index_frontmatter_in_tx(tx, binding, &draft.doc, actor, attribution.as_ref(), now_ms)?;
    Ok((result, encoded_len))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_domain::{AgentDeclaration, VersionedTextStore, WriteText};
    use dohc_test_scratch::ScratchDir;

    #[test]
    fn terminal_refusal_retires_dependent_provider_writes_and_allows_fresh_drafts() {
        let (_dir, mut store, observed, checkpoint) = fixture();
        install(&mut store, &observed, &checkpoint);
        let provider = Ydoc::wire();
        provider.apply(&checkpoint).unwrap();
        let first_delta = provider.richdoc_append_paragraph("refused first write");
        let first = pending(&mut store, &observed, first_delta);
        let second_delta = provider.richdoc_append_paragraph("dependent second write");
        let third_delta = provider.richdoc_append_paragraph("dependent third write");
        let independent = Ydoc::wire();
        independent.apply(&checkpoint).unwrap();
        let independent_delta = independent.richdoc_append_paragraph("independent write");
        let updates = [second_delta.clone(), third_delta.clone(), independent_delta];
        let append_keys = ["second", "third", "independent"];
        let mut appended = vec![first.clone()];
        for (append_key, update) in append_keys.into_iter().zip(updates) {
            appended.push(
                committed(
                    store
                        .write_with(&NoFaults, |tx| {
                            append_draft_in_tx(
                                tx,
                                "workspace",
                                &observed.binding,
                                1,
                                append_key.into(),
                                update,
                                4,
                            )
                        })
                        .unwrap(),
                )
                .unwrap(),
            );
        }
        let without_first = Ydoc::wire();
        without_first.apply(&checkpoint).unwrap();
        without_first.apply(&second_delta).unwrap();
        assert!(without_first.has_pending_dependencies());
        let writes =
            ["owner-edit", "second", "third", "independent"].map(|append_key| OwnerDraftWrite {
                outbox_id: Some(first.outbox_id.clone()),
                binding: observed.binding.clone(),
                native_head_sequence: observed.native_head_sequence,
                append_key: append_key.into(),
            });
        let refusal = OwnerOutboxRefuseInput {
            outbox_id: first.outbox_id.clone(),
            delivery_id: first.delivery_id.clone(),
            update_digest: first.update_digest.clone(),
            reason: "The presser no longer has edit access.".into(),
        };
        for _ in 0..2 {
            store
                .write_with(&NoFaults, |tx| {
                    refuse_entry_in_tx(tx, "workspace", &refusal, 12)
                })
                .unwrap();
        }
        assert_eq!(
            store
                .read_with(|conn| write_states_in(conn, "workspace", &writes))
                .unwrap(),
            ["not-accepted", "not-accepted", "not-accepted", "pending"]
        );
        for rejected in &appended[..3] {
            store.read_with(|conn| {
                let (digest, terminal): (String, String) = conn.query_row(
                    "SELECT update_digest,terminal_blob_digest FROM owner_ydoc_outbox_entries WHERE delivery_id=?1",
                    [&rejected.delivery_id], |row| Ok((row.get(0)?, row.get(1)?)),
                ).unwrap();
                assert_eq!(digest, rejected.update_digest);
                assert_eq!(hex_sha256(&bounded_blob(conn, &terminal)?), digest);
                Ok::<_, OwnerOutboxError>(())
            }).unwrap();
        }
        let reopened = store
            .read_with(|conn| open_draft_in(conn, &observed.binding, 1))
            .unwrap();
        assert_eq!(
            bounded(&reopened.doc).unwrap(),
            bounded(&independent).unwrap()
        );
        let fresh = reopened
            .doc
            .richdoc_append_paragraph("fresh authorized write");
        store
            .write_with(&NoFaults, |tx| {
                append_draft_in_tx(
                    tx,
                    "workspace",
                    &observed.binding,
                    1,
                    "fresh".into(),
                    fresh,
                    5,
                )
            })
            .unwrap();
        assert_eq!(
            store
                .read_with(|conn| write_states_in(conn, "workspace", &writes))
                .unwrap(),
            ["not-accepted", "not-accepted", "not-accepted", "pending"]
        );
    }

    #[test]
    fn terminal_entry_refusal_preserves_siblings_and_remains_refused_after_new_drafts() {
        let (_dir, mut store, observed, checkpoint) = fixture();
        install(&mut store, &observed, &checkpoint);
        let revoked = Ydoc::wire();
        revoked.apply(&checkpoint).unwrap();
        let first = pending(
            &mut store,
            &observed,
            revoked.richdoc_append_paragraph("revoked presser"),
        );
        let other = Ydoc::wire();
        other.apply(&checkpoint).unwrap();
        let second = committed(
            store
                .write_with(&NoFaults, |tx| {
                    append_draft_in_tx(
                        tx,
                        "workspace",
                        &observed.binding,
                        1,
                        "another-presser".into(),
                        other.richdoc_append_paragraph("allowed presser"),
                        4,
                    )
                })
                .unwrap(),
        )
        .unwrap();
        let writes = ["owner-edit", "another-presser"].map(|append_key| OwnerDraftWrite {
            outbox_id: Some(first.outbox_id.clone()),
            binding: observed.binding.clone(),
            native_head_sequence: observed.native_head_sequence,
            append_key: append_key.into(),
        });
        let refusal = OwnerOutboxRefuseInput {
            outbox_id: first.outbox_id.clone(),
            delivery_id: first.delivery_id.clone(),
            update_digest: first.update_digest.clone(),
            reason: "presser no longer has edit access".into(),
        };
        let mut wrong = refusal.clone();
        wrong.update_digest = "cd".repeat(32);
        assert!(store
            .write_with(&NoFaults, |tx| refuse_entry_in_tx(
                tx,
                "workspace",
                &wrong,
                12
            ))
            .is_err());
        for _ in 0..2 {
            store
                .write_with(&NoFaults, |tx| {
                    refuse_entry_in_tx(tx, "workspace", &refusal, 12)
                })
                .unwrap();
        }
        let retry = super::super::read_pending(&store, "workspace", &first.outbox_id).unwrap();
        assert_eq!(retry.entries.len(), 1);
        let revoked_delta = store.read_with(|conn| {
            let digest: String = conn.query_row("SELECT terminal_blob_digest FROM owner_ydoc_outbox_entries WHERE delivery_id=?1", [&first.delivery_id], |r| r.get(0)).unwrap();
            bounded_blob(conn, &digest)
        }).unwrap();
        let mut cache = crate::WriterDocCache::with_limits_for_test(16, 1 << 20);
        assert!(matches!(
            append_draft_cached(
                &mut store,
                &mut cache,
                "workspace",
                OwnerDraftAppendInput {
                    person_edit: false,
                    binding: observed.binding.clone(),
                    expected_revision: 1,
                    append_key: "owner-edit".into(),
                    update: revoked_delta,
                    now_ms: 5,
                    agent_declaration: None,
                    automation_declaration: None
                },
                &NoFaults
            ),
            Err(OwnerOutboxError::Frozen)
        ));
        assert_eq!(
            store
                .read_with(|conn| write_states_in(conn, "workspace", &writes))
                .unwrap(),
            ["not-accepted", "pending"]
        );
        let rows = store
            .read_with(|conn| list_drafts_in(conn, "workspace", None, 1, true))
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].state.as_deref(), Some("active"));
        let pending = super::super::read_pending(&store, "workspace", &first.outbox_id).unwrap();
        assert_eq!(pending.entries.len(), 1);
        assert_eq!(pending.entries[0].delivery_id, second.delivery_id);
        assert_eq!(rows[0].pending_bytes, pending.entries[0].byte_length);
        let reopened = store
            .read_with(|conn| open_draft_in(conn, &observed.binding, 1))
            .unwrap();
        assert_eq!(bounded(&reopened.doc).unwrap(), bounded(&other).unwrap());
        let fresh = reopened.doc.richdoc_append_paragraph("fresh allowed write");
        store
            .write_with(&NoFaults, |tx| {
                append_draft_in_tx(
                    tx,
                    "workspace",
                    &observed.binding,
                    1,
                    "fresh".into(),
                    fresh,
                    5,
                )
            })
            .unwrap();
        assert_eq!(
            store
                .read_with(|conn| write_states_in(conn, "workspace", &writes))
                .unwrap(),
            ["not-accepted", "pending"]
        );
    }

    #[test]
    fn a_new_draft_starts_from_host_changes_between_two_accepted_writes() {
        let (_dir, mut store, observed, checkpoint) = fixture();
        install(&mut store, &observed, &checkpoint);
        assert!(store
            .read_with(|conn| list_drafts_in(conn, "workspace", None, 1, true))
            .unwrap()
            .is_empty());
        let first_doc = Ydoc::wire();
        first_doc.apply(&checkpoint).unwrap();
        let delta = first_doc.richdoc_append_paragraph("first owner write");
        let first = pending(&mut store, &observed, delta.clone());
        feed(&mut store, &observed, 1, delta.clone());
        super::super::acknowledge(
            &mut store,
            "workspace",
            &first.outbox_id,
            &[OwnerDeliveryReceipt {
                delivery_id: first.delivery_id,
                update_digest: first.update_digest,
                journal_cursor: 1,
                accepting_host_epoch: 1,
            }],
        )
        .unwrap();
        assert!(store
            .read_with(|conn| list_drafts_in(conn, "workspace", None, 1, true))
            .unwrap()
            .is_empty());
        let host = Ydoc::wire();
        host.apply(&checkpoint).unwrap();
        host.apply(&delta).unwrap();
        let remote = host.richdoc_append_paragraph("host changed between writes");
        feed(&mut store, &observed, 2, remote);
        let current = store
            .read_with(|conn| read_observed_in(conn, &observed.binding))
            .unwrap()
            .unwrap();
        let second_doc = store
            .read_with(|conn| open_draft_in(conn, &observed.binding, current.revision))
            .unwrap();
        assert_eq!(bounded(&second_doc.doc).unwrap(), bounded(&host).unwrap());
        let delta = second_doc
            .doc
            .richdoc_append_paragraph("second owner write");
        store
            .write_with(&NoFaults, |tx| {
                append_draft_in_tx(
                    tx,
                    "workspace",
                    &observed.binding,
                    current.revision,
                    "second".into(),
                    delta.clone(),
                    5,
                )
            })
            .unwrap();
        host.apply(&delta).unwrap();
        let reopened = store
            .read_with(|conn| open_draft_in(conn, &observed.binding, current.revision))
            .unwrap();
        assert_eq!(bounded(&reopened.doc).unwrap(), bounded(&host).unwrap());
        assert_eq!(
            store
                .read_with(|conn| list_drafts_in(conn, "workspace", None, 1, true))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn missing_native_document_is_unsettled_and_does_not_fail_the_page() {
        let (_dir, mut store, observed, checkpoint) = fixture();
        install(&mut store, &observed, &checkpoint);
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("DELETE FROM ydoc_docs", []).map_err(write_sql)?;
                Ok::<_, OwnerOutboxError>(())
            })
            .unwrap();
        let rows = store
            .read_with(|conn| list_drafts_in(conn, "workspace", None, 64, false))
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].native_unsettled);
    }

    #[test]
    fn write_status_uses_its_receipt_even_when_a_later_entry_is_pending() {
        let (_dir, mut store, observed, checkpoint) = fixture();
        install(&mut store, &observed, &checkpoint);
        let owner = Ydoc::wire();
        owner.apply(&checkpoint).unwrap();
        let delta = owner.richdoc_append_paragraph("first");
        let append = pending(&mut store, &observed, delta.clone());
        let write = OwnerDraftWrite {
            outbox_id: Some(append.outbox_id.clone()),
            binding: observed.binding.clone(),
            native_head_sequence: observed.native_head_sequence,
            append_key: "owner-edit".to_owned(),
        };
        let status = |store: &EngineStore, write: &OwnerDraftWrite| {
            store
                .read_with(|conn| write_states_in(conn, "workspace", std::slice::from_ref(write)))
                .unwrap()
        };
        assert_eq!(status(&store, &write), ["pending"]);
        let mut missing = write.clone();
        missing.append_key = "never-appended".to_owned();
        let mut no_outbox = missing.clone();
        no_outbox.outbox_id = None;
        let mut missing_outbox = missing.clone();
        missing_outbox.outbox_id = Some("missing-outbox".to_owned());
        assert_eq!(
            store
                .read_with(|conn| write_states_in(
                    conn,
                    "workspace",
                    &[write.clone(), missing, no_outbox, missing_outbox]
                ))
                .unwrap(),
            ["pending", "absent", "absent", "absent"]
        );
        feed(&mut store, &observed, 4, delta);
        let receipt = OwnerDeliveryReceipt {
            delivery_id: append.delivery_id,
            update_digest: append.update_digest,
            journal_cursor: 4,
            accepting_host_epoch: 1,
        };
        super::super::acknowledge(&mut store, "workspace", &append.outbox_id, &[receipt]).unwrap();
        assert_eq!(status(&store, &write), ["settled"]);
        let current = store
            .read_with(|conn| read_observed_in(conn, &observed.binding))
            .unwrap()
            .unwrap();
        let later = owner.richdoc_append_paragraph("later unrelated edit");
        store
            .write_with(&NoFaults, |tx| {
                append_draft_in_tx(
                    tx,
                    "workspace",
                    &current.binding,
                    current.revision,
                    "later-edit".to_owned(),
                    later,
                    9,
                )
            })
            .unwrap();
        assert_eq!(status(&store, &write), ["settled"]);
        let mut renamed = write.clone();
        renamed.binding.current_path = "renamed.md".to_owned();
        assert_eq!(status(&store, &renamed), ["settled"]);
        renamed.append_key = "later-edit".to_owned();
        assert_eq!(status(&store, &renamed), ["pending"]);
    }

    #[test]
    fn quarantine_and_restore_generation_refuse_the_exact_unaccepted_write() {
        for fenced in [false, true] {
            let (_dir, mut store, observed, checkpoint) = fixture();
            install(&mut store, &observed, &checkpoint);
            let owner = Ydoc::wire();
            owner.apply(&checkpoint).unwrap();
            let append = pending(
                &mut store,
                &observed,
                owner.richdoc_append_paragraph("pending"),
            );
            let mut write = OwnerDraftWrite {
                outbox_id: Some(append.outbox_id.clone()),
                binding: observed.binding.clone(),
                native_head_sequence: observed.native_head_sequence,
                append_key: "owner-edit".to_owned(),
            };
            store
                .write_with(&NoFaults, |tx| {
                    if fenced {
                        let mut changed = observed.binding.clone();
                        changed.restore_fence_generation += 2;
                        tx.execute(
                            "UPDATE ydoc_owner_bindings SET binding_json=?1",
                            params![binding_json(&changed)?],
                        )
                        .map_err(write_sql)?;
                        tx.execute(
                            "INSERT INTO owner_ydoc_outboxes (outbox_id,workspace_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,base_update_digest,base_blob_digest,base_byte_length,state,pending_bytes,oldest_entry_at_ms,next_sequence,quarantine_reason,observed_binding_json,created_at_ms) SELECT 'retry-outbox',workspace_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation+1,base_update_digest,base_blob_digest,base_byte_length,state,pending_bytes,oldest_entry_at_ms,next_sequence,quarantine_reason,observed_binding_json,created_at_ms FROM owner_ydoc_outboxes WHERE outbox_id=?1",
                            params![append.outbox_id],
                        )
                        .map_err(write_sql)?;
                        let mut absent = write.clone();
                        absent.outbox_id = Some("retry-outbox".into());
                        absent.binding.restore_fence_generation += 1;
                        assert_eq!(write_states_in(tx, "workspace", &[absent])?, ["absent"]);
                        tx.execute(
                            "INSERT INTO owner_ydoc_outbox_entries (outbox_id,sequence,append_key,delivery_id,update_digest,update_blob_digest,byte_length,created_at_ms,pending,result_pending_bytes,result_oldest_entry_at_ms,result_state,draft_binding_revision) SELECT 'retry-outbox',sequence,'retry-owner-edit','retry-delivery',update_digest,update_blob_digest,byte_length,created_at_ms,pending,result_pending_bytes,result_oldest_entry_at_ms,result_state,draft_binding_revision FROM owner_ydoc_outbox_entries WHERE outbox_id=?1",
                            params![append.outbox_id],
                        ).map_err(write_sql)?;
                    } else {
                        tx.execute(
                            "UPDATE owner_ydoc_outboxes SET state='quarantined',quarantine_reason='host refused' WHERE outbox_id=?1",
                            params![append.outbox_id],
                        )
                        .map_err(write_sql)?;
                    }
                    Ok::<_, OwnerOutboxError>(())
                })
                .unwrap();
            if fenced {
                // A retry after one restore describes a new outbox, then another restore fences it.
                write.outbox_id = Some("retry-outbox".to_owned());
                write.binding.restore_fence_generation += 1;
                write.append_key = "retry-owner-edit".into();
            }
            assert_eq!(
                store
                    .read_with(|conn| write_states_in(conn, "workspace", &[write]))
                    .unwrap(),
                ["not-accepted"]
            );
        }
    }

    #[test]
    fn descriptors_distinguish_pending_delivery_from_native_settlement() {
        let (_dir, mut store, observed, checkpoint) = fixture();
        let key = key(&observed.binding).unwrap();
        store.write_with(&NoFaults, |tx| {
            crate::author_coverage::advance_in(tx, &key, false).map_err(collab)?;
            tx.execute("UPDATE ydoc_docs SET last_settled_sha=(SELECT blob_sha256 FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3)",
                params![key.workspace_id, key.version_id, key.object_id]).map_err(write_sql)?;
            Ok::<_, OwnerOutboxError>(())
        }).unwrap();
        install(&mut store, &observed, &checkpoint);
        let descriptor = |store: &EngineStore| {
            store
                .read_with(|conn| descriptor_for_key_in(conn, &key))
                .unwrap()
                .unwrap()
        };
        assert!(!descriptor(&store).native_unsettled);
        let owner = Ydoc::wire();
        owner.apply(&checkpoint).unwrap();
        let delta = owner.richdoc_append_paragraph("pending owner");
        pending(&mut store, &observed, delta.clone());
        let draft = descriptor(&store);
        assert!(draft.pending_bytes > 0);
        assert!(!draft.native_unsettled);
        feed(&mut store, &observed, 4, delta);
        assert!(descriptor(&store).native_unsettled);
        let page = store
            .read_with(|conn| list_drafts_in(conn, "workspace", None, 64, false))
            .unwrap();
        assert!(page[0].native_unsettled);
    }

    #[test]
    fn cached_drafts_discard_refused_mutations_and_reopen_after_eviction() {
        for capacity in [0, 64 * 1024 * 1024] {
            let (_dir, mut store, observed, checkpoint) = fixture();
            install(&mut store, &observed, &checkpoint);
            let mut cache = crate::WriterDocCache::with_limits_for_test(16, capacity);
            let owner = Ydoc::wire();
            owner.apply(&checkpoint).unwrap();
            let first = owner.richdoc_append_paragraph("first retained");
            let input = |append_key: &str, update: Vec<u8>| OwnerDraftAppendInput {
                person_edit: false,
                binding: observed.binding.clone(),
                expected_revision: 1,
                append_key: append_key.into(),
                update,
                now_ms: 3,
                agent_declaration: None,
                automation_declaration: None,
            };
            append_draft_cached(
                &mut store,
                &mut cache,
                "workspace",
                input("first", first),
                &NoFaults,
            )
            .unwrap();
            let fork = Ydoc::wire();
            fork.apply(&bounded(&owner).unwrap()).unwrap();
            let refused = fork.richdoc_append_paragraph("must not survive");
            assert!(append_draft_cached(
                &mut store,
                &mut cache,
                "workspace",
                input("first", refused),
                &NoFaults
            )
            .is_err());
            let second = owner.richdoc_append_paragraph("second retained");
            append_draft_cached(
                &mut store,
                &mut cache,
                "workspace",
                input("second", second),
                &NoFaults,
            )
            .unwrap();
            let snapshot = open_draft_cached(&store, &mut cache, &observed.binding, 1).unwrap();
            let cold = store
                .read_with(|conn| bounded(&open_draft_in(conn, &observed.binding, 1)?.doc))
                .unwrap();
            assert_eq!(snapshot.initial_update, cold);
            assert_eq!(snapshot.initial_update, bounded(&owner).unwrap());
            let page = store
                .read_with(|conn| list_drafts_in(conn, "workspace", None, 1, false))
                .unwrap();
            assert_eq!(page.len(), 1);
            assert_eq!(page[0].pending_bytes, snapshot.descriptor.pending_bytes);
            let cursor = OwnerDraftCursor {
                main_version_id: observed.binding.main_version_id.clone(),
                object_id: observed.binding.object_id.clone(),
                lineage_claim_id: observed.binding.lineage_claim_id.clone(),
            };
            assert!(store
                .read_with(|conn| list_drafts_in(conn, "workspace", Some(&cursor), 1, false))
                .unwrap()
                .is_empty());
            assert!(store
                .read_with(|conn| list_drafts_in(conn, "other-workspace", None, 1, false))
                .unwrap()
                .is_empty());
        }
    }

    /// An observed draft's store and writer cache, as the engine actor holds them.
    struct Drafts {
        store: EngineStore,
        cache: crate::WriterDocCache,
        binding: LiveObjectBinding,
    }

    impl Drafts {
        fn append(
            &mut self,
            append_key: &str,
            update: &[u8],
            agent_declaration: Option<AgentDeclaration>,
        ) -> Result<OwnerOutboxAppendResult, OwnerOutboxError> {
            let observed = self
                .store
                .read_with(|c| read_observed_in(c, &self.binding))
                .unwrap()
                .unwrap();
            let input = OwnerDraftAppendInput {
                person_edit: false,
                binding: self.binding.clone(),
                expected_revision: observed.revision,
                append_key: append_key.into(),
                update: update.to_vec(),
                now_ms: 3,
                agent_declaration,
                automation_declaration: None,
            };
            append_draft_cached(
                &mut self.store,
                &mut self.cache,
                "workspace",
                input,
                &NoFaults,
            )
        }

        fn assert_refused(
            &mut self,
            append_key: &str,
            update: &[u8],
            agent_declaration: Option<AgentDeclaration>,
        ) {
            assert!(matches!(
                self.append(append_key, update, agent_declaration),
                Err(OwnerOutboxError::AppendKeyMismatch)
            ));
        }
    }

    fn pending_declarations(store: &EngineStore, outbox_id: &str) -> Vec<Option<AgentDeclaration>> {
        super::super::read_pending(store, "workspace", outbox_id)
            .unwrap()
            .entries
            .into_iter()
            .map(|entry| entry.agent_declaration)
            .collect()
    }

    /// The entry header a paged read serves for `sequence`.
    fn entry_header(store: &EngineStore, outbox_id: &str, sequence: i64) -> serde_json::Value {
        let page = |cursor| {
            let result = read_pending_page(store, "workspace", outbox_id, cursor, 1 << 20);
            let Ok(OwnerOutboxPageResult::Page(page)) = result else {
                panic!("an unchanged snapshot reads a page");
            };
            page
        };
        let snapshot = page(None).cursor.snapshot;
        let header = page(Some(OwnerOutboxReadCursor {
            snapshot,
            part: OwnerOutboxReadPart::EntryHeader,
            sequence,
            offset: 0,
        }));
        serde_json::from_slice(&header.bytes).unwrap()
    }

    /// What the entry for `delivery_id` keeps after its receipt.
    fn acknowledged_declaration(store: &EngineStore, delivery_id: &str) -> Option<String> {
        store
            .read_with(|c| {
                c.query_row(
                    "SELECT agent_declaration_json FROM owner_ydoc_outbox_entries \
                     WHERE delivery_id=?1 AND pending=0",
                    [delivery_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .map_err(read_sql)
            })
            .unwrap()
    }

    #[test]
    fn person_edits_bind_append_keys_and_survive_reopen() {
        let (dir, mut store, observed, checkpoint) = fixture();
        install(&mut store, &observed, &checkpoint);
        let mut cache = crate::WriterDocCache::default();
        let owner = Ydoc::wire();
        owner.apply(&checkpoint).unwrap();
        let input = OwnerDraftAppendInput {
            person_edit: true,
            binding: observed.binding.clone(),
            expected_revision: 1,
            append_key: "person".into(),
            update: owner.richdoc_append_paragraph("Person typing"),
            now_ms: 3,
            agent_declaration: None,
            automation_declaration: None,
        };
        let appended = append_draft_cached(
            &mut store,
            &mut cache,
            "workspace",
            input.clone(),
            &NoFaults,
        )
        .unwrap();
        assert_eq!(
            entry_header(&store, &appended.outbox_id, appended.sequence)["personEdit"],
            true
        );
        assert_eq!(
            append_draft_cached(
                &mut store,
                &mut cache,
                "workspace",
                input.clone(),
                &NoFaults
            )
            .unwrap(),
            appended
        );
        let mut changed = input;
        changed.person_edit = false;
        assert!(matches!(
            append_draft_cached(&mut store, &mut cache, "workspace", changed, &NoFaults),
            Err(OwnerOutboxError::AppendKeyMismatch)
        ));
        drop(store);
        let reopened = EngineStore::open(&dir.join("engine.db"), 4).unwrap();
        assert_eq!(
            entry_header(&reopened, &appended.outbox_id, appended.sequence)["personEdit"],
            true
        );
        assert!(
            super::super::read_pending(&reopened, "workspace", &appended.outbox_id)
                .unwrap()
                .entries[0]
                .person_edit
        );
    }

    #[test]
    fn append_retry_compares_the_persisted_person_marker() {
        let (_dir, mut store, observed, checkpoint) = fixture();
        install(&mut store, &observed, &checkpoint);
        let mut cache = crate::WriterDocCache::default();
        let owner = Ydoc::wire();
        owner.apply(&checkpoint).unwrap();
        let input = OwnerDraftAppendInput {
            person_edit: false,
            binding: observed.binding,
            expected_revision: 1,
            append_key: "actorless".into(),
            update: owner.richdoc_append_paragraph("Actorless"),
            now_ms: 3,
            agent_declaration: None,
            automation_declaration: None,
        };
        let appended = append_draft_cached(
            &mut store,
            &mut cache,
            "workspace",
            input.clone(),
            &NoFaults,
        )
        .unwrap();
        assert!(entry_header(&store, &appended.outbox_id, appended.sequence)
            .get("personEdit")
            .is_none());
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE owner_ydoc_outbox_entries SET person_edit=1 WHERE delivery_id=?1",
                    [&appended.delivery_id],
                )
                .map_err(write_sql)?;
                Ok::<_, OwnerOutboxError>(())
            })
            .unwrap();
        assert!(matches!(
            append_draft_cached(&mut store, &mut cache, "workspace", input, &NoFaults),
            Err(OwnerOutboxError::AppendKeyMismatch)
        ));
    }

    #[test]
    fn automation_drafts_retain_the_presser_and_refuse_changed_retry_provenance() {
        let (_dir, mut store, observed, checkpoint) = fixture();
        install(&mut store, &observed, &checkpoint);
        let mut cache = crate::WriterDocCache::with_limits_for_test(16, 0);
        let owner = Ydoc::wire();
        owner.apply(&checkpoint).unwrap();
        let declaration = dohc_engine_domain::AutomationDeclaration {
            automation_id: "collection:Tasks#mark".into(),
            attribution: dohc_engine_domain::ChangeAttribution {
                actor_kind: dohc_engine_domain::ChangeActorKind::Automation,
                on_behalf_of: Some("presser".into()),
                depth: 1,
                run: Some(dohc_engine_domain::AutomationRunAttribution {
                    claim_id: "claim".into(),
                    automation_name: "Mark done".into(),
                }),
            },
        };
        let input = OwnerDraftAppendInput {
            person_edit: false,
            binding: observed.binding,
            expected_revision: 1,
            append_key: "press/Status".into(),
            update: owner.richdoc_append_paragraph("Done"),
            now_ms: 3,
            agent_declaration: None,
            automation_declaration: Some(declaration.clone()),
        };
        let appended = append_draft_cached(
            &mut store,
            &mut cache,
            "workspace",
            input.clone(),
            &NoFaults,
        )
        .unwrap();
        let replayed = append_draft_cached(
            &mut store,
            &mut cache,
            "workspace",
            input.clone(),
            &NoFaults,
        )
        .unwrap();
        assert_eq!(appended.delivery_id, replayed.delivery_id);
        assert_eq!(appended.sequence, replayed.sequence);
        let pending = super::super::read_pending(&store, "workspace", &appended.outbox_id).unwrap();
        assert_eq!(pending.entries.len(), 1);
        assert_eq!(
            pending.entries[0].automation_declaration,
            Some(declaration.clone())
        );
        assert_eq!(
            entry_header(&store, &appended.outbox_id, appended.sequence)["automationDeclaration"],
            serde_json::to_value(declaration).unwrap()
        );
        let mut changed = input;
        changed
            .automation_declaration
            .as_mut()
            .unwrap()
            .attribution
            .on_behalf_of = Some("different-person".into());
        assert!(matches!(
            append_draft_cached(&mut store, &mut cache, "workspace", changed, &NoFaults),
            Err(OwnerOutboxError::AppendKeyMismatch)
        ));
    }

    #[test]
    fn agent_declarations_bind_append_keys_and_survive_ack_and_reopen() {
        let declared = AgentDeclaration {
            agent_id: "trip-agent".into(),
            on_behalf_of: Some("local-person".into()),
            depth: 2,
        };
        let changed = [
            Some(AgentDeclaration {
                agent_id: "other-agent".into(),
                ..declared.clone()
            }),
            Some(AgentDeclaration {
                on_behalf_of: None,
                ..declared.clone()
            }),
            Some(AgentDeclaration {
                depth: 3,
                ..declared.clone()
            }),
            None,
        ];
        let agent = Some(declared.clone());
        let wire = serde_json::json!({
            "agentId": "trip-agent",
            "onBehalfOf": "local-person",
            "depth": 2
        });
        // A cache that retains nothing reopens each draft cold.
        for capacity in [0, 64 * 1024 * 1024] {
            let (dir, mut store, observed, checkpoint) = fixture();
            install(&mut store, &observed, &checkpoint);
            let mut drafts = Drafts {
                store,
                cache: crate::WriterDocCache::with_limits_for_test(16, capacity),
                binding: observed.binding.clone(),
            };
            let owner = Ydoc::wire();
            owner.apply(&checkpoint).unwrap();
            let agent_edit = owner.richdoc_append_paragraph("agent edit");
            let own_edit = owner.richdoc_append_paragraph("person edit");
            let refuses = |drafts: &mut Drafts| {
                for declaration in changed.clone() {
                    drafts.assert_refused("agent", &agent_edit, declaration);
                }
                drafts.assert_refused("person", &own_edit, agent.clone());
            };

            let first = drafts.append("agent", &agent_edit, agent.clone()).unwrap();
            let second = drafts.append("person", &own_edit, None).unwrap();
            // Each draft records the enrolled revision it was queued under.
            for result in [&first, &second] {
                let revision: Option<i64> = drafts
                    .store
                    .read_with(|c| {
                        c.query_row(
                            "SELECT draft_binding_revision FROM owner_ydoc_outbox_entries WHERE delivery_id=?1",
                            [&result.delivery_id],
                            |row| row.get(0),
                        )
                        .map_err(read_sql)
                    })
                    .unwrap();
                assert_eq!(revision, Some(observed.revision));
            }
            assert_eq!(
                drafts.append("agent", &agent_edit, agent.clone()).unwrap(),
                first
            );
            refuses(&mut drafts);
            let fork = Ydoc::wire();
            fork.apply(&checkpoint).unwrap();
            let other_bytes = fork.richdoc_append_paragraph("other bytes");
            drafts.assert_refused("agent", &other_bytes, agent.clone());
            let invalid = AgentDeclaration {
                agent_id: String::new(),
                ..declared.clone()
            };
            assert!(matches!(
                drafts.append("invalid", &other_bytes, Some(invalid)),
                Err(OwnerOutboxError::InvalidInput(_))
            ));
            assert_eq!(
                pending_declarations(&drafts.store, &first.outbox_id),
                vec![agent.clone(), None]
            );
            assert_eq!(
                entry_header(&drafts.store, &first.outbox_id, first.sequence)["agentDeclaration"],
                wire
            );
            let plain = entry_header(&drafts.store, &first.outbox_id, second.sequence);
            assert!(plain.get("agentDeclaration").is_none());

            // The relay accepts the agent's draft. Its receipt releases the
            // bytes and keeps what the draft declared.
            feed(&mut drafts.store, &observed, 2, agent_edit.clone());
            let receipt = OwnerDeliveryReceipt {
                delivery_id: first.delivery_id.clone(),
                update_digest: first.update_digest.clone(),
                journal_cursor: 2,
                accepting_host_epoch: 1,
            };
            super::super::acknowledge(&mut drafts.store, "workspace", &first.outbox_id, &[receipt])
                .unwrap();
            let expected_json = serde_json::to_string(&declared).unwrap();
            assert_eq!(
                acknowledged_declaration(&drafts.store, &first.delivery_id),
                Some(expected_json.clone())
            );
            assert_eq!(
                drafts.append("agent", &agent_edit, agent.clone()).unwrap(),
                first
            );
            refuses(&mut drafts);

            drop(drafts);
            let mut drafts = Drafts {
                store: EngineStore::open(&dir.join("engine.db"), 13).unwrap(),
                cache: crate::WriterDocCache::with_limits_for_test(16, capacity),
                binding: observed.binding.clone(),
            };
            assert_eq!(
                acknowledged_declaration(&drafts.store, &first.delivery_id),
                Some(expected_json)
            );
            assert_eq!(
                pending_declarations(&drafts.store, &first.outbox_id),
                vec![None]
            );
            refuses(&mut drafts);
            assert_eq!(drafts.append("person", &own_edit, None).unwrap(), second);
        }
    }

    fn fixture() -> (ScratchDir, EngineStore, ObservedOwnerBinding, Vec<u8>) {
        let dir = ScratchDir::new_named("observed-owner-draft").unwrap();
        let mut store = EngineStore::open(&dir.join("engine.db"), 0).unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version("workspace", "main", 0, &NoFaults)
            .unwrap();
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/owner-source/owner-source-seed.json"
        ))
        .unwrap();
        let original: Vec<u8> = serde_json::from_value(fixture["bytes"].clone()).unwrap();
        VersionedTextStore::new(&mut store)
            .write_text(
                &WriteText {
                    workspace_id: "workspace".into(),
                    version_id: "main".into(),
                    object_id: "object".into(),
                    path: "owner.md".into(),
                    text: fixture["markdown"].as_str().unwrap().into(),
                    moment_id: "original".into(),
                    metadata_origin: "user".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 1,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
        let key = DocKey::new("workspace", "main", "object").unwrap();
        crate::claim_base(
            &mut store,
            &key,
            crate::ContentKind::Richdoc,
            &original,
            &NoFaults,
            2,
        )
        .unwrap();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("UPDATE ydoc_docs SET path='owner.md'", [])
                    .unwrap();
                Ok::<_, OwnerOutboxError>(())
            })
            .unwrap();
        let (head, checkpoint) = store
            .read_with(|conn| {
                Ok::<_, OwnerOutboxError>((
                    crate::read_marker_in(conn, &key)
                        .map_err(collab)?
                        .unwrap()
                        .head_update_seq,
                    bounded(&crate::load_doc_in(conn, &key).map_err(collab)?)?,
                ))
            })
            .unwrap();
        let observed = ObservedOwnerBinding {
            binding: LiveObjectBinding {
                workspace_id: "workspace".into(),
                main_version_id: "main".into(),
                object_id: "object".into(),
                lineage_claim_id: hex_sha256(&original),
                current_path: "owner.md".into(),
                selector_paths: vec!["owner.md".into()],
                restore_fence_generation: 0,
            },
            relay_database_namespace: "relay".into(),
            revision: 1,
            accepted_cursor: 0,
            native_head_sequence: head,
            checkpoint_digest: hex_sha256(&checkpoint),
            limits: OwnerOutboxLimits {
                max_pending_bytes: 1_000_000,
                max_pending_age_ms: 60_000,
            },
        };
        (dir, store, observed, checkpoint)
    }
    fn install(store: &mut EngineStore, observed: &ObservedOwnerBinding, checkpoint: &[u8]) {
        store
            .write_with(&NoFaults, |tx| {
                install_observed_binding_in_tx(tx, "workspace", observed, checkpoint)
            })
            .unwrap();
    }
    #[test]
    fn rejects_divergent_checkpoint_and_stale_native_head_without_installing() {
        let (_dir, mut store, observed, checkpoint) = fixture();
        let doc = Ydoc::wire();
        doc.apply(&checkpoint).unwrap();
        doc.richdoc_append_paragraph("remote edit");
        let changed = bounded(&doc).unwrap();
        let mut wrong = observed.clone();
        wrong.checkpoint_digest = hex_sha256(&changed);
        assert!(store
            .write_with(&NoFaults, |tx| install_observed_binding_in_tx(
                tx,
                "workspace",
                &wrong,
                &changed
            ))
            .is_err());
        wrong = observed;
        wrong.native_head_sequence += 1;
        assert!(store
            .write_with(&NoFaults, |tx| install_observed_binding_in_tx(
                tx,
                "workspace",
                &wrong,
                &checkpoint
            ))
            .is_err());
        assert_eq!(store.table_row_count("ydoc_owner_bindings").unwrap(), 0);
    }
    #[test]
    fn draft_reopens_exact_pending_bytes_without_ordinary_publication() {
        let (dir, mut store, observed, checkpoint) = fixture();
        install(&mut store, &observed, &checkpoint);
        let pending = Ydoc::wire();
        pending.apply(&checkpoint).unwrap();
        let update = pending.richdoc_append_paragraph("offline owner draft");
        let append = store
            .write_with(&NoFaults, |tx| {
                append_draft_in_tx(
                    tx,
                    "workspace",
                    &observed.binding,
                    1,
                    "edit-1".into(),
                    update.clone(),
                    3,
                )
            })
            .unwrap();
        let result = committed(append).unwrap();
        let key = key(&observed.binding).unwrap();
        assert!(store
            .write_with(&NoFaults, |tx| crate::record_update_in_tx(
                tx, &key, &update, None, None, 4
            ))
            .is_err());
        assert!(crate::settle(&mut store, &key, "owner.md", &NoFaults, 4).is_err());
        assert!(super::super::acknowledge(
            &mut store,
            "workspace",
            &result.outbox_id,
            &[OwnerDeliveryReceipt {
                delivery_id: result.delivery_id,
                update_digest: result.update_digest,
                journal_cursor: 1,
                accepting_host_epoch: 1,
            }]
        )
        .is_err());
        drop(store);
        let reopened = EngineStore::open(&dir.join("engine.db"), 5).unwrap();
        let actual = reopened
            .read_with(|conn| {
                let draft = open_draft_in(conn, &observed.binding, 1)?;
                assert_eq!(
                    crate::read_marker_in(conn, &key)
                        .map_err(collab)?
                        .unwrap()
                        .head_update_seq,
                    observed.native_head_sequence
                );
                bounded(&draft.doc)
            })
            .unwrap();
        assert_eq!(actual, bounded(&pending).unwrap());
        assert_eq!(
            reopened
                .table_row_count("owner_ydoc_outbox_entries")
                .unwrap(),
            1
        );
    }
    #[test]
    fn stale_revision_and_invalid_delta_leave_the_queue_empty() {
        let (_dir, mut store, observed, checkpoint) = fixture();
        install(&mut store, &observed, &checkpoint);
        for (revision, update) in [(2, vec![0, 0]), (1, vec![255])] {
            assert!(store
                .write_with(&NoFaults, |tx| append_draft_in_tx(
                    tx,
                    "workspace",
                    &observed.binding,
                    revision,
                    "edit".into(),
                    update,
                    3
                ))
                .is_err());
        }
        assert_eq!(
            store.table_row_count("owner_ydoc_outbox_entries").unwrap(),
            0
        );
    }
    #[test]
    fn original_claim_draft_refuses_an_update_that_introduces_a_lineage_epoch() {
        use yrs::{updates::decoder::Decode, Doc, Map, ReadTxn, Transact, Update};
        let (_dir, mut store, observed, checkpoint) = fixture();
        install(&mut store, &observed, &checkpoint);
        let changed = Doc::new();
        let meta = changed.get_or_insert_map(crate::ydoc::ROOT_META);
        let update = {
            let mut tx = changed.transact_mut();
            tx.apply_update(Update::decode_v1(&checkpoint).unwrap())
                .unwrap();
            let before = tx.state_vector();
            meta.insert(&mut tx, crate::ydoc::LINEAGE_EPOCH_META_KEY, "injected");
            tx.encode_state_as_update_v1(&before)
        };
        assert!(matches!(
            store.write_with(&NoFaults, |tx| append_draft_in_tx(
                tx,
                "workspace",
                &observed.binding,
                1,
                "injected-epoch".into(),
                update,
                3
            )),
            Err(OwnerOutboxError::ParentMismatch)
        ));
        assert_eq!(
            store.table_row_count("owner_ydoc_outbox_entries").unwrap(),
            0
        );
    }
    #[test]
    fn observation_retains_original_base_without_an_outbox_or_native_snapshot() {
        let (_dir, mut store, mut observed, checkpoint) = fixture();
        let doc = Ydoc::wire();
        doc.apply(&checkpoint).unwrap();
        let delta = doc.richdoc_append_paragraph("accepted change");
        let key = key(&observed.binding).unwrap();
        store
            .write_with(&NoFaults, |tx| {
                crate::record_update_in_tx(tx, &key, &delta, None, None, 3)
            })
            .unwrap();
        let checkpoint = bounded(&doc).unwrap();
        observed.checkpoint_digest = hex_sha256(&checkpoint);
        observed.native_head_sequence = store
            .read_with(|conn| crate::read_marker_in(conn, &key))
            .unwrap()
            .unwrap()
            .head_update_seq;
        assert_ne!(
            observed.binding.lineage_claim_id,
            observed.checkpoint_digest
        );
        install(&mut store, &observed, &checkpoint);
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("DELETE FROM ydoc_snapshots", []).unwrap();
                assert!(tx
                    .execute(
                        "DELETE FROM binary_blobs WHERE sha256=?1",
                        [&observed.binding.lineage_claim_id]
                    )
                    .is_err());
                Ok::<_, OwnerOutboxError>(())
            })
            .unwrap();
        assert_eq!(store.table_row_count("owner_ydoc_outboxes").unwrap(), 0);
    }
    #[test]
    fn draft_open_refuses_marker_kind_or_regime_drift_without_a_head_change() {
        for assignment in [
            "content_kind='plaintext'",
            "regime='local-only', lineage_claim_status='unclaimed', lineage_claim_id=NULL, lineage_parent_claim_id=NULL, lineage_epoch_tag=NULL",
        ] {
            let (_dir, mut store, observed, checkpoint) = fixture();
            install(&mut store, &observed, &checkpoint);
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute(&format!("UPDATE ydoc_docs SET {assignment}"), [])
                        .unwrap();
                    assert!(matches!(
                        open_draft_in(tx, &observed.binding, 1),
                        Err(OwnerOutboxError::ParentMismatch)
                    ));
                    Ok::<_, OwnerOutboxError>(())
                })
                .unwrap();
        }
    }
    fn refuse_for_good(store: &mut EngineStore, outbox_id: &str) {
        super::super::quarantine(
            store,
            "workspace",
            super::super::OwnerOutboxQuarantineInput {
                outbox_id: outbox_id.into(),
                reason: "invalid-update".into(),
                observed_binding: None,
            },
            5,
        )
        .unwrap();
    }
    fn try_again(
        store: &mut EngineStore,
        observed: &ObservedOwnerBinding,
        outbox_id: &str,
    ) -> Result<String, OwnerOutboxError> {
        super::super::retry(
            store,
            "workspace",
            super::super::OwnerOutboxRetryInput {
                outbox_id: outbox_id.into(),
                binding: observed.binding.clone(),
            },
        )
    }
    #[test]
    fn an_accepted_try_again_on_an_observed_binding_is_applied_and_resumes_delivery() {
        let (_dir, mut store, observed, checkpoint) = fixture();
        install(&mut store, &observed, &checkpoint);
        let owner = Ydoc::wire();
        owner.apply(&checkpoint).unwrap();
        let head_delta = owner.richdoc_append_paragraph("refused, then tried again");
        let head = pending(&mut store, &observed, head_delta.clone());
        let suffix_delta = owner.richdoc_append_paragraph("later owner edit");
        let suffix = committed(
            store
                .write_with(&NoFaults, |tx| {
                    append_draft_in_tx(
                        tx,
                        "workspace",
                        &observed.binding,
                        1,
                        "owner-suffix".into(),
                        suffix_delta.clone(),
                        4,
                    )
                })
                .unwrap(),
        )
        .unwrap();
        refuse_for_good(&mut store, &head.outbox_id);
        let listed = |store: &EngineStore| {
            store
                .read_with(|c| list_drafts_in(c, "workspace", None, 64, true))
                .unwrap()
                .len()
        };
        assert_eq!(listed(&store), 0);
        let receipt = |append: &OwnerOutboxAppendResult, cursor| OwnerDeliveryReceipt {
            delivery_id: append.delivery_id.clone(),
            update_digest: append.update_digest.clone(),
            journal_cursor: cursor,
            accepting_host_epoch: 1,
        };
        let applied = |store: &EngineStore, receipt: &OwnerDeliveryReceipt| {
            store.read_with(|c| {
                super::super::accepted::is_receipt_applied_in(
                    c,
                    &observed.binding,
                    &observed.relay_database_namespace,
                    receipt,
                )
            })
        };
        let head_receipt = receipt(&head, 4);
        assert!(matches!(
            applied(&store, &head_receipt),
            Err(OwnerOutboxError::Frozen)
        ));
        assert_eq!(
            try_again(&mut store, &observed, &head.outbox_id).unwrap(),
            head.delivery_id
        );
        assert_eq!(listed(&store), 1, "a granted draft is listed for delivery");
        feed(&mut store, &observed, 4, head_delta);
        assert!(applied(&store, &head_receipt).unwrap());
        // The grant covers the head alone.
        let suffix_receipt = receipt(&suffix, 6);
        assert!(matches!(
            applied(&store, &suffix_receipt),
            Err(OwnerOutboxError::Frozen)
        ));
        super::super::acknowledge(
            &mut store,
            "workspace",
            &head.outbox_id,
            std::slice::from_ref(&head_receipt),
        )
        .unwrap();
        let resumed = super::super::read_pending(&store, "workspace", &head.outbox_id).unwrap();
        assert_eq!(resumed.state, super::super::OwnerOutboxState::Active);
        assert_eq!(resumed.quarantine_reason, None);
        assert_eq!(resumed.retry_delivery_id, None);
        assert_eq!(resumed.entries.len(), 1);
        feed(&mut store, &observed, 6, suffix_delta);
        assert!(applied(&store, &suffix_receipt).unwrap());
        super::super::acknowledge(&mut store, "workspace", &head.outbox_id, &[suffix_receipt])
            .unwrap();
        assert_eq!(
            super::super::read_pending(&store, "workspace", &head.outbox_id)
                .unwrap()
                .entries
                .len(),
            0
        );
    }
    #[test]
    fn try_again_refuses_a_document_no_longer_live_at_the_owner_binding() {
        for assignment in [
            "path='moved.md'",
            "lineage_claim_status='unclaimed', lineage_claim_id=NULL, lineage_parent_claim_id=NULL, lineage_epoch_tag=NULL",
            "regime='local-only', lineage_claim_status='unclaimed', lineage_claim_id=NULL, lineage_parent_claim_id=NULL, lineage_epoch_tag=NULL",
        ] {
            let (_dir, mut store, observed, checkpoint) = fixture();
            install(&mut store, &observed, &checkpoint);
            let owner = Ydoc::wire();
            owner.apply(&checkpoint).unwrap();
            let head = pending(
                &mut store,
                &observed,
                owner.richdoc_append_paragraph("refused"),
            );
            refuse_for_good(&mut store, &head.outbox_id);
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute(&format!("UPDATE ydoc_docs SET {assignment}"), [])
                        .unwrap();
                    Ok::<_, OwnerOutboxError>(())
                })
                .unwrap();
            assert!(
                matches!(
                    try_again(&mut store, &observed, &head.outbox_id),
                    Err(OwnerOutboxError::ParentMismatch)
                ),
                "{assignment}"
            );
            assert_eq!(
                super::super::read_pending(&store, "workspace", &head.outbox_id)
                    .unwrap()
                    .retry_delivery_id,
                None,
                "{assignment}"
            );
        }
    }
    #[test]
    fn try_again_refuses_an_observed_binding_whose_document_is_gone() {
        let (_dir, mut store, observed, checkpoint) = fixture();
        install(&mut store, &observed, &checkpoint);
        let owner = Ydoc::wire();
        owner.apply(&checkpoint).unwrap();
        let head = pending(
            &mut store,
            &observed,
            owner.richdoc_append_paragraph("refused"),
        );
        refuse_for_good(&mut store, &head.outbox_id);
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("DELETE FROM ydoc_docs", []).unwrap();
                Ok::<_, OwnerOutboxError>(())
            })
            .unwrap();
        assert!(store
            .read_with(|c| read_observed_in(c, &observed.binding))
            .unwrap()
            .is_some());
        assert!(matches!(
            try_again(&mut store, &observed, &head.outbox_id),
            Err(OwnerOutboxError::ParentMismatch)
        ));
        assert_eq!(
            super::super::read_pending(&store, "workspace", &head.outbox_id)
                .unwrap()
                .retry_delivery_id,
            None
        );
    }
    #[test]
    fn retiring_the_granted_head_ends_its_try_again() {
        let (_dir, mut store, observed, checkpoint) = fixture();
        install(&mut store, &observed, &checkpoint);
        let owner = Ydoc::wire();
        owner.apply(&checkpoint).unwrap();
        let head = pending(
            &mut store,
            &observed,
            owner.richdoc_append_paragraph("refused twice"),
        );
        refuse_for_good(&mut store, &head.outbox_id);
        assert_eq!(
            try_again(&mut store, &observed, &head.outbox_id).unwrap(),
            head.delivery_id
        );
        let refusal = OwnerOutboxRefuseInput {
            outbox_id: head.outbox_id.clone(),
            delivery_id: head.delivery_id.clone(),
            update_digest: head.update_digest.clone(),
            reason: "The presser no longer has edit access.".into(),
        };
        committed(
            store
                .write_with(&NoFaults, |tx| {
                    refuse_entry_in_tx(tx, "workspace", &refusal, 12)
                })
                .unwrap(),
        )
        .unwrap();
        let retired = super::super::read_pending(&store, "workspace", &head.outbox_id).unwrap();
        assert_eq!(retired.state, super::super::OwnerOutboxState::Quarantined);
        assert_eq!(retired.retry_delivery_id, None);
        assert!(retired.entries.is_empty());
    }
    fn feed(
        store: &mut EngineStore,
        observed: &ObservedOwnerBinding,
        cursor: i64,
        update: Vec<u8>,
    ) -> super::super::accepted::OwnerAcceptedFrameInput {
        let current = store
            .read_with(|c| read_observed_in(c, &observed.binding))
            .unwrap()
            .unwrap();
        let input = super::super::accepted::OwnerAcceptedFrameInput {
            binding: observed.binding.clone(),
            relay_database_namespace: observed.relay_database_namespace.clone(),
            expected_revision: current.revision,
            expected_native_head_sequence: current.native_head_sequence,
            previous_accepted_cursor: current.accepted_cursor,
            journal_cursor: cursor,
            update_bytes: update,
        };
        store
            .write_with(&NoFaults, |tx| {
                super::super::accepted::apply_frame_in_tx(tx, "workspace", &input, 10)
            })
            .unwrap();
        input
    }
    fn pending(
        store: &mut EngineStore,
        observed: &ObservedOwnerBinding,
        update: Vec<u8>,
    ) -> OwnerOutboxAppendResult {
        let result = store
            .write_with(&NoFaults, |tx| {
                append_draft_in_tx(
                    tx,
                    "workspace",
                    &observed.binding,
                    1,
                    "owner-edit".into(),
                    update,
                    3,
                )
            })
            .unwrap();
        committed(result).unwrap()
    }
    #[test]
    fn ordered_feed_contains_late_ack_and_preserves_exact_receipt_retry() {
        let (dir, mut store, observed, checkpoint) = fixture();
        install(&mut store, &observed, &checkpoint);
        let remote_changes = |store: &EngineStore| {
            store
                .read_with(|c| dohc_engine_storage::remote_changes_applied_in(c, "workspace"))
                .unwrap()
        };
        let owner = Ydoc::wire();
        owner.apply(&checkpoint).unwrap();
        let delta = owner.richdoc_append_paragraph("pending owner");
        let append = pending(&mut store, &observed, delta.clone());
        let receipt = OwnerDeliveryReceipt {
            delivery_id: append.delivery_id,
            update_digest: append.update_digest,
            journal_cursor: 4,
            accepting_host_epoch: 1,
        };
        assert!(super::super::acknowledge(
            &mut store,
            "workspace",
            &append.outbox_id,
            std::slice::from_ref(&receipt)
        )
        .is_err());
        let remote = Ydoc::wire();
        remote.apply(&checkpoint).unwrap();
        let remote_delta = remote.richdoc_append_paragraph("remote first");
        feed(&mut store, &observed, 2, remote_delta);
        assert_eq!(remote_changes(&store), 1, "another computer's frame counts");
        let mut wrong = receipt.clone();
        wrong.journal_cursor = 1;
        assert!(!store
            .read_with(|c| super::super::accepted::is_receipt_applied_in(
                c,
                &observed.binding,
                &observed.relay_database_namespace,
                &wrong
            ))
            .unwrap());
        let ordinary_before = store.table_row_count("replication_log").unwrap();
        let retry = feed(&mut store, &observed, 4, delta);
        assert_eq!(remote_changes(&store), 1, "the owner's own draft does not");
        assert_eq!(
            store.table_row_count("replication_log").unwrap(),
            ordinary_before
        );
        let before = store.table_row_count("ydoc_updates").unwrap();
        store
            .write_with(&NoFaults, |tx| {
                super::super::accepted::apply_frame_in_tx(tx, "workspace", &retry, 11)
            })
            .unwrap();
        assert_eq!(store.table_row_count("ydoc_updates").unwrap(), before);
        assert_eq!(remote_changes(&store), 1, "nor does a replayed frame");
        let mut wrong_retry = retry.clone();
        wrong_retry.relay_database_namespace = "other-relay".into();
        assert!(store
            .write_with(&NoFaults, |tx| super::super::accepted::apply_frame_in_tx(
                tx,
                "workspace",
                &wrong_retry,
                11
            ))
            .is_err());
        let later = remote.richdoc_append_paragraph("remote later");
        feed(&mut store, &observed, 9, later);
        assert_eq!(remote_changes(&store), 2);
        assert_eq!(
            store.table_row_count("ydoc_owner_applied_frames").unwrap(),
            1
        );
        assert!(store
            .read_with(|c| super::super::accepted::is_receipt_applied_in(
                c,
                &observed.binding,
                &observed.relay_database_namespace,
                &receipt
            ))
            .unwrap());
        super::super::acknowledge(
            &mut store,
            "workspace",
            &append.outbox_id,
            std::slice::from_ref(&receipt),
        )
        .unwrap();
        drop(store);
        let mut reopened = EngineStore::open(&dir.join("engine.db"), 12).unwrap();
        assert_eq!(remote_changes(&reopened), 2, "the count survives a restart");
        super::super::acknowledge(
            &mut reopened,
            "workspace",
            &append.outbox_id,
            std::slice::from_ref(&receipt),
        )
        .unwrap();
        let mut altered = receipt;
        altered.accepting_host_epoch += 1;
        assert!(super::super::acknowledge(
            &mut reopened,
            "workspace",
            &append.outbox_id,
            &[altered]
        )
        .is_err());
        let state = reopened
            .read_with(|c| read_observed_in(c, &observed.binding))
            .unwrap()
            .unwrap();
        assert_eq!(state.accepted_cursor, 9);
        assert_eq!(
            super::super::read_pending(&reopened, "workspace", &append.outbox_id)
                .unwrap()
                .entries
                .len(),
            0
        );
        // The draft's bytes served again under a later cursor are not the
        // draft the relay acknowledged at cursor 4.
        feed(&mut reopened, &observed, 12, retry.update_bytes.clone());
        assert_eq!(remote_changes(&reopened), 3);
    }
    #[test]
    fn accepted_write_failure_rolls_back_native_state_cursor_and_pending_work() {
        let (_dir, mut store, observed, checkpoint) = fixture();
        install(&mut store, &observed, &checkpoint);
        let owner = Ydoc::wire();
        owner.apply(&checkpoint).unwrap();
        let delta = owner.richdoc_append_paragraph("pending owner");
        let append = pending(&mut store, &observed, delta.clone());
        store.write_with(&NoFaults,|tx| {
            tx.execute_batch("CREATE TRIGGER refuse_owner_advance BEFORE UPDATE ON ydoc_owner_bindings BEGIN SELECT RAISE(ABORT,'test write failure'); END;").unwrap();
            Ok::<_,OwnerOutboxError>(())
        }).unwrap();
        let input = super::super::accepted::OwnerAcceptedFrameInput {
            binding: observed.binding.clone(),
            relay_database_namespace: "relay".into(),
            expected_revision: 1,
            expected_native_head_sequence: observed.native_head_sequence,
            previous_accepted_cursor: 0,
            journal_cursor: 4,
            update_bytes: delta,
        };
        assert!(store
            .write_with(&NoFaults, |tx| super::super::accepted::apply_frame_in_tx(
                tx,
                "workspace",
                &input,
                4
            ))
            .is_err());
        let state = store
            .read_with(|c| read_observed_in(c, &observed.binding))
            .unwrap()
            .unwrap();
        assert_eq!(state.accepted_cursor, 0);
        assert_eq!(state.native_head_sequence, observed.native_head_sequence);
        assert_eq!(
            super::super::read_pending(&store, "workspace", &append.outbox_id)
                .unwrap()
                .entries
                .len(),
            1
        );
        assert_eq!(
            store.table_row_count("ydoc_owner_applied_frames").unwrap(),
            0
        );
    }
    #[test]
    fn late_receipt_containment_includes_delete_sets_and_overlapping_state() {
        let (_dir, mut store, observed, checkpoint) = fixture();
        install(&mut store, &observed, &checkpoint);
        let owner = Ydoc::wire();
        owner.apply(&checkpoint).unwrap();
        let delta = owner
            .rewrite_content_to_markdown(crate::ContentKind::Richdoc, "replacement\n")
            .unwrap();
        let append = pending(&mut store, &observed, delta.clone());
        let receipt = OwnerDeliveryReceipt {
            delivery_id: append.delivery_id,
            update_digest: append.update_digest,
            journal_cursor: 4,
            accepting_host_epoch: 1,
        };
        feed(&mut store, &observed, 4, delta);
        let full = bounded(&owner).unwrap();
        feed(&mut store, &observed, 8, full);
        assert!(store
            .read_with(|c| super::super::accepted::is_receipt_applied_in(
                c,
                &observed.binding,
                &observed.relay_database_namespace,
                &receipt
            ))
            .unwrap());
        super::super::acknowledge(&mut store, "workspace", &append.outbox_id, &[receipt]).unwrap();
    }

    #[test]
    fn initial_sync_advances_a_cut_retries_and_keeps_pending_separate() {
        use super::super::accepted::{apply_sync_in_tx, read_state_in, OwnerAcceptedFrameInput};
        let (_dir, mut store, observed, checkpoint) = fixture();
        install(&mut store, &observed, &checkpoint);
        let owner = Ydoc::wire();
        owner.apply(&checkpoint).unwrap();
        let pending_update = owner.richdoc_append_paragraph("private pending");
        let append = pending(&mut store, &observed, pending_update);
        let host = Ydoc::wire();
        host.apply(&checkpoint).unwrap();
        let update = host.richdoc_append_paragraph("remote accepted");
        let input = OwnerAcceptedFrameInput {
            binding: observed.binding.clone(),
            relay_database_namespace: observed.relay_database_namespace.clone(),
            expected_revision: observed.revision,
            expected_native_head_sequence: observed.native_head_sequence,
            previous_accepted_cursor: 0,
            journal_cursor: 19,
            update_bytes: update,
        };
        let wrong_vector = owner.encode_state_vector();
        assert!(store
            .write_with(&NoFaults, |tx| apply_sync_in_tx(
                tx,
                "workspace",
                &input,
                &wrong_vector,
                20
            ))
            .is_err());
        let vector = host.encode_state_vector();
        store
            .write_with(&NoFaults, |tx| {
                apply_sync_in_tx(tx, "workspace", &input, &vector, 20)
            })
            .unwrap();
        let before = store
            .read_with(|c| read_state_in(c, &observed.binding, "relay"))
            .unwrap();
        store
            .write_with(&NoFaults, |tx| {
                apply_sync_in_tx(tx, "workspace", &input, &vector, 21)
            })
            .unwrap();
        let after = store
            .read_with(|c| read_state_in(c, &observed.binding, "relay"))
            .unwrap();
        assert_eq!(before.native_head_sequence, after.native_head_sequence);
        assert_eq!(after.revision, 2);
        assert_eq!(after.accepted_cursor, 19);
        assert_eq!(after.state_vector, vector);
        let receipt = OwnerDeliveryReceipt {
            delivery_id: append.delivery_id,
            update_digest: append.update_digest,
            journal_cursor: 3,
            accepting_host_epoch: 1,
        };
        assert!(!store
            .read_with(|c| super::super::accepted::is_receipt_applied_in(
                c,
                &observed.binding,
                "relay",
                &receipt
            ))
            .unwrap());
        let unchanged = OwnerAcceptedFrameInput {
            expected_revision: after.revision,
            expected_native_head_sequence: after.native_head_sequence,
            previous_accepted_cursor: 19,
            journal_cursor: 19,
            update_bytes: vec![0, 0],
            ..input
        };
        store
            .write_with(&NoFaults, |tx| {
                apply_sync_in_tx(tx, "workspace", &unchanged, &vector, 22)
            })
            .unwrap();
        let final_state = store
            .read_with(|c| read_state_in(c, &observed.binding, "relay"))
            .unwrap();
        assert_eq!(after.native_head_sequence, final_state.native_head_sequence);
        assert_eq!(after.revision, final_state.revision);
    }
}
