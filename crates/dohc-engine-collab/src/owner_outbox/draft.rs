//! Unmounted non-host owner draft storage. No RPC installs these bindings.
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

fn collab(error: CollabError) -> OwnerOutboxError {
    match error {
        CollabError::Storage(error) => OwnerOutboxError::Storage(error),
        _ => OwnerOutboxError::InvalidInput("invalid owner draft state"),
    }
}
fn key(binding: &LiveObjectBinding) -> Result<DocKey, OwnerOutboxError> {
    DocKey::new(
        &binding.workspace_id,
        &binding.main_version_id,
        &binding.object_id,
    )
    .map_err(collab)
}
fn bounded(doc: &Ydoc) -> Result<Vec<u8>, OwnerOutboxError> {
    doc.encode_full_state_bounded(crate::limits::MAX_YDOC_UPDATE_BYTES)
        .ok_or(OwnerOutboxError::InvalidInput(
            "owner draft exceeds document limit",
        ))
}

/// Refuse ordinary publication and settlement before either writes durable state.
pub(crate) fn require_ordinary_write(conn: &Connection, key: &DocKey) -> Result<(), CollabError> {
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
    let adopted: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM live_owner_adoptions WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3)",
        params![b.workspace_id,b.main_version_id,b.object_id], |row| row.get(0),
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

fn bounded_blob(conn: &Connection, digest: &str) -> Result<Vec<u8>, OwnerOutboxError> {
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
fn read_observed_in(
    conn: &Connection,
    binding: &LiveObjectBinding,
) -> Result<Option<ObservedOwnerBinding>, OwnerOutboxError> {
    let b = binding;
    let raw: Option<(String,String,i64,i64,i64,String,i64,i64)> = conn.query_row(
        &format!("SELECT binding_json,relay_database_namespace,binding_revision,accepted_cursor,native_head_sequence,checkpoint_digest,max_pending_bytes,max_pending_age_ms FROM ydoc_owner_bindings WHERE {SCOPE}"),
        params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?)),
    ).optional().map_err(read_sql)?;
    raw.map(|r| {
        let saved: LiveObjectBinding =
            serde_json::from_str(&r.0).map_err(|_| OwnerOutboxError::Corrupt)?;
        if &saved != binding {
            return Err(OwnerOutboxError::ParentMismatch);
        }
        Ok(ObservedOwnerBinding {
            binding: saved,
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
    })
    .transpose()
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
    if marker.head_update_seq != observed.native_head_sequence
        || marker.lineage_claim_id.as_deref() != Some(&binding.lineage_claim_id)
        || marker.path.as_deref() != Some(&binding.current_path)
    {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    let doc = Ydoc::wire();
    doc.apply(&bounded_blob(conn, &observed.checkpoint_digest)?)
        .map_err(collab)?;
    if let Some(parent) = find_parent_for_binding(conn, binding)? {
        if parent.binding != *binding || parent.state == OwnerOutboxState::Quarantined {
            return Err(OwnerOutboxError::Frozen);
        }
        let mut stmt = conn.prepare("SELECT update_digest,byte_length FROM owner_ydoc_outbox_entries WHERE outbox_id=?1 AND pending=1 ORDER BY sequence").map_err(read_sql)?;
        let rows = stmt
            .query_map([parent.outbox_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })
            .map_err(read_sql)?;
        let mut remaining = observed
            .limits
            .max_pending_bytes
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
            bounded(&doc)?;
        }
    }
    if doc.has_pending_dependencies() {
        return Err(OwnerOutboxError::ParentMismatch);
    }
    Ok(OwnerDraft { observed, doc })
}

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
    if update.is_empty() || update.len() > crate::limits::MAX_YDOC_UPDATE_BYTES {
        return Err(OwnerOutboxError::InvalidInput("invalid draft update size"));
    }
    let epoch = draft
        .doc
        .lineage_epoch_tag()
        .ok_or(OwnerOutboxError::ParentMismatch)?;
    draft
        .doc
        .apply_preserving_lineage_epoch(&update, &epoch)
        .map_err(collab)?;
    draft
        .doc
        .project(crate::ContentKind::Richdoc)
        .map_err(collab)?;
    bounded(&draft.doc)?;
    append_with_retained_base(
        tx,
        workspace_id,
        OwnerOutboxAppendInput {
            binding: binding.clone(),
            base_update: bounded_blob(tx, &binding.lineage_claim_id)?,
            append_key,
            update,
            limits: draft.observed.limits,
            created_at_ms: now_ms,
        },
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_domain::{VersionedTextStore, WriteText};
    use dohc_test_scratch::ScratchDir;

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
}
